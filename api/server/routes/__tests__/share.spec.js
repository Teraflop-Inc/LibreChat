const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');

const mockGetSharedLinkExpiration = jest.fn();
const mockGrantCreationPermissions = jest.fn();
const mockUpdateSharedLinkPermissionsExpiration = jest.fn();
const mockSharedLinksAccess = jest.fn((_req, _res, next) => next());
const mockBuildSharedLinkStartupPayload = jest.fn();
const mockCanAccessSharedLink = jest.fn((req, _res, next) => {
  req.shareResourceId = 'resource-123';
  next();
});
const mockGetAppConfig = jest.fn();
const mockGetTenantId = jest.fn(() => undefined);
const mockAssertConversationContentAllowed = jest.fn();
const mockAssertModelBoundContent = jest.fn();
const mockAssertSharedFileMetadataAllowed = jest.fn();

jest.mock('@librechat/api', () => ({
  assertModelBoundContent: (...args) => mockAssertModelBoundContent(...args),
  assertSharedFileMetadataAllowed: (...args) => mockAssertSharedFileMetadataAllowed(...args),
  isEnabled: jest.fn(() => true),
  generateCheckAccess: jest.fn(() => mockSharedLinksAccess),
  grantCreationPermissions: (...args) => mockGrantCreationPermissions(...args),
  updateSharedLinkPermissionsExpiration: (...args) =>
    mockUpdateSharedLinkPermissionsExpiration(...args),
  ensureLinkPermissions: jest.fn(),
  isFileSnapshotEnabled: jest.fn(() => true),
  isFileSnapshotKillSwitchActive: jest.fn(() => false),
  buildSharedLinkStartupPayload: (...args) => mockBuildSharedLinkStartupPayload(...args),
  deleteSharedLinkWithCleanup: jest.fn(),
  getSharedLinkExpiration: (...args) => mockGetSharedLinkExpiration(...args),
  isActiveExpirationDate: jest.fn((expiredAt) => expiredAt > new Date()),
  isContentFilterError: jest.fn(
    (error) =>
      error?.code === 'content_filter_block' || error?.code === 'content_filter_uninspectable',
  ),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
  getTenantId: (...args) => mockGetTenantId(...args),
  createTempChatExpirationDate: jest.fn(() => new Date('2030-01-01T00:00:00.000Z')),
  runAsSystem: jest.fn((fn) => fn()),
  tenantStorage: { run: jest.fn((_ctx, fn) => fn()) },
  SYSTEM_TENANT_ID: '__SYSTEM__',
}));

jest.mock('librechat-data-provider', () => ({
  PermissionTypes: {
    SHARED_LINKS: 'SHARED_LINKS',
  },
  Permissions: {
    CREATE: 'CREATE',
    SHARE_PUBLIC: 'SHARE_PUBLIC',
  },
  RetentionMode: {
    ALL: 'all',
    TEMPORARY: 'temporary',
  },
  FileSources: {
    local: 'local',
    s3: 's3',
    cloudfront: 'cloudfront',
    azure_blob: 'azure_blob',
    firebase: 'firebase',
    text: 'text',
  },
}));

jest.mock('mongoose', () => ({
  models: {
    Conversation: {
      findOne: jest.fn(),
    },
    SharedLink: {
      findOne: jest.fn(),
    },
  },
}));

jest.mock('~/models', () => ({
  getFiles: jest.fn(),
  updateFile: jest.fn(),
  getSharedMessages: jest.fn(),
  createSharedLink: jest.fn(),
  updateSharedLink: jest.fn(),
  deleteSharedLink: jest.fn(),
  getSharedLinks: jest.fn(),
  getSharedLink: jest.fn(),
  getSharedLinkFile: jest.fn(),
  backfillSharedLinkFiles: jest.fn(),
  getRoleByName: jest.fn(),
}));

const mockGetStrategyFunctions = jest.fn();
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: (...args) => mockGetStrategyFunctions(...args),
}));
jest.mock('~/server/utils/files', () => ({
  cleanFileName: jest.fn((name) => name),
  getContentDisposition: jest.fn((name, disposition = 'attachment') => `${disposition}; ${name}`),
}));

jest.mock(
  '~/server/middleware/canAccessSharedLink',
  () =>
    (...args) =>
      mockCanAccessSharedLink(...args),
);
jest.mock('~/server/middleware/optionalShareFileAuth', () => (_req, _res, next) => next());
jest.mock('~/server/middleware/optionalJwtAuth', () => (req, _res, next) => next());
jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());
jest.mock('~/server/middleware/config/app', () => (_req, _res, next) => next());
jest.mock('~/server/services/Config/app', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

jest.mock('~/server/middleware/limiters', () => ({
  createForkLimiters: () => ({
    forkIpLimiter: (_req, _res, next) => next(),
    forkUserLimiter: (_req, _res, next) => next(),
  }),
}));

jest.mock('~/server/utils/import/fork', () => ({
  forkSharedConversation: jest.fn(),
}));
jest.mock('~/server/utils/import/importBatchBuilder', () => ({
  assertConversationContentAllowed: (...args) => mockAssertConversationContentAllowed(...args),
}));

const { Readable } = require('stream');
const { RetentionMode } = require('librechat-data-provider');
const { createTempChatExpirationDate, logger } = require('@librechat/data-schemas');
const {
  deleteSharedLinkWithCleanup,
  isFileSnapshotEnabled,
  isFileSnapshotKillSwitchActive,
} = require('@librechat/api');
const {
  getFiles,
  updateFile,
  getSharedMessages,
  createSharedLink,
  updateSharedLink,
  getSharedLinkFile,
  backfillSharedLinkFiles,
  getRoleByName,
} = require('~/models');
const { forkSharedConversation } = require('~/server/utils/import/fork');
const shareRouter = require('../share');

const activeExpiration = new Date('2030-01-01T00:00:00.000Z');
const expiredExpiration = new Date('2020-01-01T00:00:00.000Z');
const contentFilters = {
  messages: {
    pii: {
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
    },
  },
};

const lean = (value) => ({
  lean: jest.fn().mockResolvedValue(value),
});

const buildApp = ({
  retentionMode = RetentionMode.TEMPORARY,
  user = { id: 'user-123' },
  filters,
  messageFilter,
} = {}) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    req.config = {
      interfaceConfig: { retentionMode },
      ...(filters == null ? {} : { filters }),
      ...(messageFilter == null ? {} : { messageFilter }),
    };
    next();
  });
  app.use('/api/share', shareRouter);
  return app;
};

const mockSharedMessagesResult = (result) => {
  getSharedMessages.mockImplementation(async (_shareId, _resourceId, options) => {
    await options?.preflight?.(result);
    return result;
  });
};

describe('share routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTenantId.mockReturnValue(undefined);
    mockGetAppConfig.mockResolvedValue({
      interfaceConfig: {
        privacyPolicy: { externalUrl: 'https://example.com/privacy' },
      },
    });
    mockBuildSharedLinkStartupPayload.mockReturnValue({
      appTitle: 'Shared Chat',
      bundlerURL: 'https://bundler.example.com',
      interface: {
        privacyPolicy: { externalUrl: 'https://example.com/privacy' },
      },
    });
    getRoleByName.mockResolvedValue({
      permissions: {
        SHARED_LINKS: {
          SHARE_PUBLIC: true,
        },
      },
    });
    mockGrantCreationPermissions.mockResolvedValue(undefined);
  });

  it('serves shared startup config after shared-link access is granted', async () => {
    const response = await request(buildApp()).get('/api/share/share-123/config');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(mockCanAccessSharedLink).toHaveBeenCalled();
    expect(mockGetAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    expect(mockBuildSharedLinkStartupPayload).toHaveBeenCalledWith({
      interfaceConfig: {
        privacyPolicy: { externalUrl: 'https://example.com/privacy' },
      },
    });
    expect(response.body).toEqual({
      appTitle: 'Shared Chat',
      bundlerURL: 'https://bundler.example.com',
      interface: {
        privacyPolicy: { externalUrl: 'https://example.com/privacy' },
      },
    });
  });

  it('uses tenant-scoped app config for shared startup config when tenant context is present', async () => {
    mockGetTenantId.mockReturnValue('tenant-abc');

    const response = await request(buildApp()).get('/api/share/share-123/config');

    expect(response.status).toBe(200);
    expect(mockGetAppConfig).toHaveBeenCalledWith({ tenantId: 'tenant-abc' });
  });

  it('uses base app config for shared startup config in system context', async () => {
    mockGetTenantId.mockReturnValue('__SYSTEM__');

    const response = await request(buildApp()).get('/api/share/share-123/config');

    expect(response.status).toBe(200);
    expect(mockGetAppConfig).toHaveBeenCalledWith({ baseOnly: true });
  });

  it('prevents successful shared message responses from being cached', async () => {
    mockSharedMessagesResult({ shareId: 'share-123', messages: [] });

    const response = await request(buildApp()).get('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(mockAssertConversationContentAllowed).not.toHaveBeenCalled();
    expect(mockAssertSharedFileMetadataAllowed).not.toHaveBeenCalled();
  });

  it('reapplies the current content policy before serving an existing share', async () => {
    const share = {
      shareId: 'share-123',
      title: 'Protected Conversation',
      messages: [
        {
          text: 'safe message',
          files: [{ file_id: 'file-1', filename: 'safe-report.pdf' }],
          attachments: [{ file_id: 'file-2', name: 'safe-image.png' }],
          content: [
            {
              type: 'steer',
              steer: 'safe user steer',
              files: [{ file_id: 'file-3', filename: 'safe-context.txt' }],
            },
          ],
        },
      ],
    };
    mockSharedMessagesResult(share);

    const response = await request(buildApp({ filters: contentFilters })).get(
      '/api/share/share-123',
    );

    expect(response.status).toBe(200);
    expect(mockAssertConversationContentAllowed).toHaveBeenCalledWith(contentFilters, {
      conversations: [{ title: share.title }],
      messages: [
        {
          text: 'safe message',
          content: [{ type: 'steer', steer: 'safe user steer' }],
        },
      ],
    });
    expect(mockAssertSharedFileMetadataAllowed).toHaveBeenCalledWith({
      filters: contentFilters,
      messages: share.messages,
      shareId: 'share-123',
    });
  });

  it('threads a legacy-only detector into strict shared-content preflight', async () => {
    const strictFilters = {
      messages: { unattributedAssistantContent: 'inspect' },
    };
    const legacyPii = {
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
    };
    const share = {
      shareId: 'share-123',
      title: 'Protected Conversation',
      messages: [{ isCreatedByUser: false, role: 'assistant', text: 'safe model output' }],
    };
    mockSharedMessagesResult(share);

    const response = await request(
      buildApp({ filters: strictFilters, messageFilter: { pii: legacyPii } }),
    ).get('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(mockAssertConversationContentAllowed).toHaveBeenCalledWith(
      strictFilters,
      {
        conversations: [{ title: share.title }],
        messages: share.messages,
      },
      { legacyPii },
    );
  });

  it('keeps shared-message preflight active with only legacy message filtering', async () => {
    const legacyPii = { starterPatterns: ['sk_prefix'] };
    const share = {
      shareId: 'share-123',
      title: 'Protected Conversation',
      messages: [{ isCreatedByUser: true, text: 'safe user input' }],
    };
    mockSharedMessagesResult(share);

    const response = await request(buildApp({ messageFilter: { pii: legacyPii } })).get(
      '/api/share/share-123',
    );

    expect(response.status).toBe(200);
    expect(mockAssertConversationContentAllowed).toHaveBeenCalledWith(
      undefined,
      {
        conversations: [{ title: share.title }],
        messages: share.messages,
      },
      { legacyPii },
    );
  });

  it('returns a raw-free 400 when existing shared metadata fails current policy', async () => {
    const error = Object.assign(new Error('PRIVATE-SENTINEL'), {
      code: 'content_filter_block',
      statusCode: 400,
      body: {
        error: 'content_filter_block',
        message: 'Submitted content contains a private value. Remove it and try again.',
        source: 'message',
        field: 'attachment_reference',
      },
    });
    mockSharedMessagesResult({
      shareId: 'share-123',
      title: 'Protected Conversation',
      messages: [
        {
          text: 'safe message',
          files: [{ file_id: 'file-1', filename: 'PRIVATE-SENTINEL.pdf' }],
        },
      ],
    });
    mockAssertSharedFileMetadataAllowed.mockImplementationOnce(() => {
      throw error;
    });

    const response = await request(buildApp({ filters: contentFilters })).get(
      '/api/share/share-123',
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual(error.body);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE-SENTINEL');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('rechecks legacy shared response fields before returning public JSON', async () => {
    const error = Object.assign(new Error('PRIVATE-SENTINEL'), {
      code: 'content_filter_block',
      statusCode: 400,
      body: {
        error: 'content_filter_block',
        message: 'Submitted content contains a private value. Remove it and try again.',
        source: 'message',
        field: 'attachment_reference',
      },
    });
    const share = {
      shareId: 'share-123',
      title: 'Legacy Shared Conversation',
      messages: [
        {
          isCreatedByUser: true,
          text: 'safe message',
          iconURL: 'https://example.test/PRIVATE-SENTINEL',
        },
      ],
    };
    mockSharedMessagesResult(share);
    mockAssertSharedFileMetadataAllowed.mockImplementationOnce(() => {
      throw error;
    });

    const response = await request(buildApp({ filters: contentFilters })).get(
      '/api/share/share-123',
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual(error.body);
    expect(mockAssertSharedFileMetadataAllowed).toHaveBeenCalledWith({
      filters: contentFilters,
      messages: share.messages,
      shareId: share.shareId,
    });
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE-SENTINEL');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('returns a raw-free 400 when an existing share fails the current policy', async () => {
    const error = Object.assign(new Error('PRIVATE-SENTINEL'), {
      code: 'content_filter_block',
      statusCode: 400,
      body: {
        error: 'content_filter_block',
        message: 'Submitted content contains a private value. Remove it and try again.',
        source: 'message',
        field: 'text',
      },
    });
    mockSharedMessagesResult({
      shareId: 'share-123',
      title: 'Protected Conversation',
      messages: [{ text: 'PRIVATE-SENTINEL' }],
    });
    mockAssertConversationContentAllowed.mockImplementationOnce(() => {
      throw error;
    });

    const response = await request(buildApp({ filters: contentFilters })).get(
      '/api/share/share-123',
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual(error.body);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE-SENTINEL');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('expires new shares for retained non-temporary conversations', async () => {
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    createSharedLink.mockResolvedValue({ _id: 'link-123', shareId: 'share-123' });

    const response = await request(buildApp())
      .post('/api/share/convo-123')
      .send({ targetMessageId: 'msg-123' });

    expect(response.status).toBe(200);
    expect(mockGetSharedLinkExpiration).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'convo-123',
        req: expect.objectContaining({ user: { id: 'user-123' } }),
      }),
      expect.objectContaining({
        getConvo: expect.any(Function),
        createExpirationDate: createTempChatExpirationDate,
        logger,
      }),
    );
    const [, dependencies] = mockGetSharedLinkExpiration.mock.calls[0];
    mongoose.models.Conversation.findOne.mockReturnValue(lean({ expiredAt: activeExpiration }));
    await dependencies.getConvo('user-123', 'convo-123');
    expect(mongoose.models.Conversation.findOne).toHaveBeenCalledWith(
      { conversationId: 'convo-123', user: 'user-123' },
      'isTemporary expiredAt',
    );
    expect(createSharedLink).toHaveBeenCalledWith(
      'user-123',
      'convo-123',
      'msg-123',
      new Date('2030-01-01T00:00:00.000Z'),
      true,
    );
    expect(mockGrantCreationPermissions).toHaveBeenCalledWith(
      'link-123',
      'user-123',
      true,
      new Date('2030-01-01T00:00:00.000Z'),
    );
    expect(mockSharedLinksAccess).toHaveBeenCalled();
  });

  it('snapshots files by default when the user does not opt out', async () => {
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    createSharedLink.mockResolvedValue({ _id: 'link-123', shareId: 'share-123' });

    await request(buildApp()).post('/api/share/convo-123').send({ targetMessageId: 'msg-123' });

    expect(createSharedLink).toHaveBeenCalledWith(
      'user-123',
      'convo-123',
      'msg-123',
      expect.anything(),
      true,
    );
  });

  it('returns a raw-free 400 when the exact create snapshot fails policy preflight', async () => {
    const error = Object.assign(new Error('PRIVATE-SENTINEL'), {
      code: 'content_filter_block',
      statusCode: 400,
      body: {
        error: 'content_filter_block',
        message: 'Submitted content contains a private value. Remove it and try again.',
        source: 'message',
        field: 'text',
      },
    });
    const messages = [{ text: 'PRIVATE-SENTINEL' }];
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    mockAssertConversationContentAllowed.mockImplementationOnce(() => {
      throw error;
    });
    createSharedLink.mockImplementationOnce(async (...args) => {
      await args[5]({ title: 'Protected Conversation', messages });
      return { _id: 'link-123', shareId: 'share-123' };
    });

    const response = await request(buildApp({ filters: contentFilters }))
      .post('/api/share/convo-123')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body).toEqual(error.body);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE-SENTINEL');
    expect(mockAssertConversationContentAllowed).toHaveBeenCalledWith(
      contentFilters,
      {
        conversations: [{ title: 'Protected Conversation' }],
        messages,
      },
      {
        user: { id: 'user-123' },
        getFiles,
      },
    );
    expect(mockGrantCreationPermissions).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('checks public message metadata before creating the shared link', async () => {
    const error = Object.assign(new Error('PRIVATE-SENTINEL'), {
      code: 'content_filter_block',
      statusCode: 400,
      body: {
        error: 'content_filter_block',
        message: 'Submitted content contains a private value. Remove it and try again.',
        source: 'message',
        field: 'attachment_reference',
      },
    });
    const messages = [
      {
        isCreatedByUser: true,
        text: 'safe message',
        iconURL: 'https://example.test/PRIVATE-SENTINEL',
      },
    ];
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    mockAssertSharedFileMetadataAllowed.mockImplementationOnce(() => {
      throw error;
    });
    createSharedLink.mockImplementationOnce(async (...args) => {
      await args[5]({ title: 'Protected Conversation', messages });
      return { _id: 'link-123', shareId: 'share-123' };
    });

    const response = await request(buildApp({ filters: contentFilters }))
      .post('/api/share/convo-123')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body).toEqual(error.body);
    expect(mockAssertConversationContentAllowed).toHaveBeenCalledWith(
      contentFilters,
      {
        conversations: [{ title: 'Protected Conversation' }],
        messages,
      },
      {
        user: { id: 'user-123' },
        getFiles,
      },
    );
    expect(mockAssertSharedFileMetadataAllowed).toHaveBeenCalledWith({
      filters: contentFilters,
      messages,
      shareId: undefined,
      includeFiles: false,
    });
    expect(mockGrantCreationPermissions).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE-SENTINEL');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('preflights only the exact text snapshot when shared files are opted out', async () => {
    const messages = [
      {
        text: 'safe message',
        files: [{ file_id: 'file-top-level' }],
        attachments: [{ file_id: 'attachment-top-level' }],
        content: [
          { type: 'text', text: 'safe model content' },
          {
            type: 'steer',
            steer: 'safe user steer',
            files: [{ file_id: 'steer-file' }],
          },
        ],
      },
    ];
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    createSharedLink.mockImplementationOnce(async (...args) => {
      await args[5]({ title: 'Protected Conversation', messages });
      return { _id: 'link-123', shareId: 'share-123' };
    });

    const response = await request(buildApp({ filters: contentFilters }))
      .post('/api/share/convo-123')
      .send({ snapshotFiles: false });

    expect(response.status).toBe(200);
    expect(mockAssertConversationContentAllowed).toHaveBeenCalledWith(
      contentFilters,
      {
        conversations: [{ title: 'Protected Conversation' }],
        messages: [
          {
            text: 'safe message',
            content: [
              { type: 'text', text: 'safe model content' },
              { type: 'steer', steer: 'safe user steer' },
            ],
          },
        ],
      },
      {
        user: { id: 'user-123' },
        getFiles,
      },
    );
  });

  it('does not snapshot files when the user opts out (snapshotFiles=false)', async () => {
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    createSharedLink.mockResolvedValue({ _id: 'link-123', shareId: 'share-123' });

    await request(buildApp())
      .post('/api/share/convo-123')
      .send({ targetMessageId: 'msg-123', snapshotFiles: false });

    expect(createSharedLink).toHaveBeenCalledWith(
      'user-123',
      'convo-123',
      'msg-123',
      expect.anything(),
      false,
    );
  });

  it('forces snapshotFiles=false when the feature is disabled, ignoring the body flag', async () => {
    isFileSnapshotEnabled.mockReturnValueOnce(false);
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    createSharedLink.mockResolvedValue({ _id: 'link-123', shareId: 'share-123' });

    await request(buildApp())
      .post('/api/share/convo-123')
      .send({ targetMessageId: 'msg-123', snapshotFiles: true });

    expect(createSharedLink).toHaveBeenCalledWith(
      'user-123',
      'convo-123',
      'msg-123',
      expect.anything(),
      false,
    );
  });

  it('passes the snapshotFiles opt-out through on update', async () => {
    mongoose.models.SharedLink.findOne.mockReturnValue(lean({ conversationId: 'convo-123' }));
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    updateSharedLink.mockResolvedValue({ _id: 'link-456', shareId: 'share-456' });

    await request(buildApp()).patch('/api/share/share-123').send({ snapshotFiles: false });

    expect(updateSharedLink).toHaveBeenCalledWith(
      'user-123',
      'share-123',
      undefined,
      expect.anything(),
      false,
    );
  });

  it('returns a raw-free 400 when the exact update snapshot fails policy preflight', async () => {
    const error = Object.assign(new Error('PRIVATE-SENTINEL'), {
      code: 'content_filter_uninspectable',
      statusCode: 400,
      body: {
        error: 'content_filter_uninspectable',
        message: 'Submitted file content could not be inspected before processing.',
        source: 'file',
        field: 'content',
      },
    });
    const messages = [{ files: [{ file_id: 'file_PRIVATE-SENTINEL' }] }];
    mongoose.models.SharedLink.findOne.mockReturnValue(lean({ conversationId: 'convo-123' }));
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    mockAssertConversationContentAllowed.mockImplementationOnce(() => {
      throw error;
    });
    updateSharedLink.mockImplementationOnce(async (...args) => {
      await args[5]({ title: 'Protected Share', messages });
      return { _id: 'link-456', shareId: 'share-456' };
    });

    const response = await request(buildApp({ filters: contentFilters })).patch(
      '/api/share/share-123',
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual(error.body);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE-SENTINEL');
    expect(mockAssertConversationContentAllowed).toHaveBeenCalledWith(
      contentFilters,
      {
        conversations: [{ title: 'Protected Share' }],
        messages,
      },
      {
        user: { id: 'user-123' },
        getFiles,
      },
    );
    expect(mockUpdateSharedLinkPermissionsExpiration).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('rejects new shares when the retained conversation expired', async () => {
    mockGetSharedLinkExpiration.mockResolvedValue(expiredExpiration);
    createSharedLink.mockResolvedValue({ _id: 'link-123', shareId: 'share-123' });

    const response = await request(buildApp())
      .post('/api/share/convo-123')
      .send({ targetMessageId: 'msg-123' });

    expect(response.status).toBe(404);
    expect(createSharedLink).not.toHaveBeenCalled();
  });

  it('rejects new shares for expired conversations in all retention mode', async () => {
    mockGetSharedLinkExpiration.mockResolvedValue(expiredExpiration);
    createSharedLink.mockResolvedValue({ _id: 'link-123', shareId: 'share-123' });

    const response = await request(buildApp({ retentionMode: RetentionMode.ALL }))
      .post('/api/share/convo-123')
      .send({ targetMessageId: 'msg-123' });

    expect(response.status).toBe(404);
    expect(createSharedLink).not.toHaveBeenCalled();
  });

  it('expires updated shares for retained non-temporary conversations', async () => {
    mongoose.models.SharedLink.findOne.mockReturnValue(lean({ conversationId: 'convo-123' }));
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    updateSharedLink.mockResolvedValue({ _id: 'link-456', shareId: 'share-456' });

    const response = await request(buildApp()).patch('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(mongoose.models.SharedLink.findOne).toHaveBeenCalledWith(
      { shareId: 'share-123', user: 'user-123' },
      'conversationId',
    );
    expect(mockGetSharedLinkExpiration).toHaveBeenCalledTimes(1);
    expect(mockGetSharedLinkExpiration).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'convo-123',
        req: expect.objectContaining({ user: { id: 'user-123' } }),
      }),
      expect.objectContaining({
        getConvo: expect.any(Function),
        createExpirationDate: createTempChatExpirationDate,
        logger,
      }),
    );
    expect(updateSharedLink).toHaveBeenCalledWith(
      'user-123',
      'share-123',
      undefined,
      new Date('2030-01-01T00:00:00.000Z'),
      true,
    );
    expect(mockUpdateSharedLinkPermissionsExpiration).toHaveBeenCalledWith(
      'link-456',
      new Date('2030-01-01T00:00:00.000Z'),
    );
  });

  it('rejects updated shares when the retained conversation expired', async () => {
    mongoose.models.SharedLink.findOne.mockReturnValue(lean({ conversationId: 'convo-123' }));
    mockGetSharedLinkExpiration.mockResolvedValue(expiredExpiration);
    updateSharedLink.mockResolvedValue({ shareId: 'share-456' });

    const response = await request(buildApp()).patch('/api/share/share-123');

    expect(response.status).toBe(404);
    expect(updateSharedLink).not.toHaveBeenCalled();
  });

  it('rejects updated shares for expired conversations in all retention mode', async () => {
    mongoose.models.SharedLink.findOne.mockReturnValue(lean({ conversationId: 'convo-123' }));
    mockGetSharedLinkExpiration.mockResolvedValue(expiredExpiration);
    updateSharedLink.mockResolvedValue({ shareId: 'share-456' });

    const response = await request(buildApp({ retentionMode: RetentionMode.ALL })).patch(
      '/api/share/share-123',
    );

    expect(response.status).toBe(404);
    expect(mongoose.models.SharedLink.findOne).toHaveBeenCalledWith(
      { shareId: 'share-123', user: 'user-123' },
      'conversationId',
    );
    expect(updateSharedLink).not.toHaveBeenCalled();
  });

  it('clears updated share expiration when the conversation is no longer retained', async () => {
    mongoose.models.SharedLink.findOne.mockReturnValue(lean({ conversationId: 'convo-123' }));
    mockGetSharedLinkExpiration.mockResolvedValue(null);
    updateSharedLink.mockResolvedValue({ _id: 'link-456', shareId: 'share-456' });

    const response = await request(buildApp()).patch('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(updateSharedLink).toHaveBeenCalledWith('user-123', 'share-123', undefined, null, true);
    expect(mockUpdateSharedLinkPermissionsExpiration).toHaveBeenCalledWith('link-456', null);
    expect(mockSharedLinksAccess).not.toHaveBeenCalled();
  });

  it('preserves updated share expiration when the conversation cannot be found', async () => {
    mongoose.models.SharedLink.findOne.mockReturnValue(lean({ conversationId: 'convo-123' }));
    mockGetSharedLinkExpiration.mockResolvedValue(undefined);
    updateSharedLink.mockResolvedValue({ shareId: 'share-456' });

    const response = await request(buildApp()).patch('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(updateSharedLink).toHaveBeenCalledWith(
      'user-123',
      'share-123',
      undefined,
      undefined,
      true,
    );
    expect(mockUpdateSharedLinkPermissionsExpiration).not.toHaveBeenCalled();
  });

  it('clears updated share expiration when creating a new expiration throws', async () => {
    const error = new Error('bad config');
    mongoose.models.SharedLink.findOne.mockReturnValue(lean({ conversationId: 'convo-123' }));
    mockGetSharedLinkExpiration.mockImplementationOnce(async (_input, dependencies) => {
      dependencies.logger.error('[getSharedLinkExpiration] Error creating expiration date:', error);
      return null;
    });
    updateSharedLink.mockResolvedValue({ _id: 'link-456', shareId: 'share-456' });

    const response = await request(buildApp()).patch('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(logger.error).toHaveBeenCalledWith(
      '[getSharedLinkExpiration] Error creating expiration date:',
      error,
    );
    expect(updateSharedLink).toHaveBeenCalledWith('user-123', 'share-123', undefined, null, true);
    expect(mockUpdateSharedLinkPermissionsExpiration).toHaveBeenCalledWith('link-456', null);
  });

  it('updates share target message while applying retention expiration', async () => {
    mongoose.models.SharedLink.findOne.mockReturnValue(lean({ conversationId: 'convo-123' }));
    mockGetSharedLinkExpiration.mockResolvedValue(activeExpiration);
    updateSharedLink.mockResolvedValue({ shareId: 'share-456', targetMessageId: 'msg-456' });

    const response = await request(buildApp())
      .patch('/api/share/share-123')
      .send({ targetMessageId: 'msg-456' });

    expect(response.status).toBe(200);
    expect(updateSharedLink).toHaveBeenCalledWith(
      'user-123',
      'share-123',
      'msg-456',
      new Date('2030-01-01T00:00:00.000Z'),
      true,
    );
  });

  it('rejects non-string target message updates', async () => {
    const response = await request(buildApp())
      .patch('/api/share/share-123')
      .send({ targetMessageId: 123 });

    expect(response.status).toBe(400);
    expect(updateSharedLink).not.toHaveBeenCalled();
  });

  it('allows deleting existing shares without CREATE permission gate', async () => {
    deleteSharedLinkWithCleanup.mockResolvedValue({ shareId: 'share-123' });

    const response = await request(buildApp()).delete('/api/share/share-123');

    expect(response.status).toBe(200);
    expect(mockSharedLinksAccess).not.toHaveBeenCalled();
    expect(deleteSharedLinkWithCleanup).toHaveBeenCalledWith('user-123', 'share-123');
  });
});

describe('share fork route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forks a shared conversation for the requesting user', async () => {
    const forkResult = {
      conversation: { conversationId: 'convo-456', title: 'Shared Title' },
      messages: [{ messageId: 'msg-456' }],
    };
    forkSharedConversation.mockResolvedValue(forkResult);

    const response = await request(
      buildApp({ user: { id: 'user-123', role: 'USER', tenantId: 'tenant-viewer' } }),
    )
      .post('/api/share/share-123/fork')
      .send({ targetMessageIndex: 3 });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(forkResult);
    expect(forkSharedConversation).toHaveBeenCalledWith({
      shareId: 'share-123',
      shareResourceId: 'resource-123',
      requestUserId: 'user-123',
      userRole: 'USER',
      userTenantId: 'tenant-viewer',
      targetMessageIndex: 3,
      snapshotFiles: true,
      sharedContentPreflight: undefined,
    });
  });

  it('passes current shared-content policy into the fork read preflight', async () => {
    const share = {
      shareId: 'share-123',
      title: 'Protected Conversation',
      messages: [{ text: 'safe', files: [{ filename: 'safe-report.pdf' }] }],
    };
    forkSharedConversation.mockImplementationOnce(async ({ sharedContentPreflight }) => {
      await sharedContentPreflight(share);
      return {
        conversation: { conversationId: 'convo-456' },
        messages: [],
      };
    });

    const response = await request(buildApp({ filters: contentFilters })).post(
      '/api/share/share-123/fork',
    );

    expect(response.status).toBe(201);
    expect(mockAssertConversationContentAllowed).toHaveBeenCalledWith(contentFilters, {
      conversations: [{ title: share.title }],
      messages: [{ text: 'safe' }],
    });
    expect(mockAssertSharedFileMetadataAllowed).toHaveBeenCalledWith({
      filters: contentFilters,
      messages: share.messages,
      shareId: share.shareId,
    });
  });

  it('forces snapshotFiles=false into the fork when the file snapshot kill switch is active', async () => {
    isFileSnapshotKillSwitchActive.mockReturnValueOnce(true);
    forkSharedConversation.mockResolvedValue({
      conversation: { conversationId: 'convo-456' },
      messages: [],
    });

    await request(buildApp()).post('/api/share/share-123/fork');

    expect(forkSharedConversation).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotFiles: false }),
    );
  });

  it('returns 404 when the shared conversation is missing or empty', async () => {
    forkSharedConversation.mockResolvedValue(null);

    const response = await request(buildApp()).post('/api/share/share-123/fork');

    expect(response.status).toBe(404);
  });

  it('returns 500 when forking fails', async () => {
    forkSharedConversation.mockRejectedValue(new Error('db down'));

    const response = await request(buildApp()).post('/api/share/share-123/fork');

    expect(response.status).toBe(500);
  });
});

describe('share-scoped file routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetStrategyFunctions.mockReturnValue({
      getDownloadStream: jest.fn(async () => Readable.from(['file-bytes'])),
    });
    // Live file record present by default (resolveShareFile requires it).
    getFiles.mockResolvedValue([{ status: 'ready' }]);
  });

  it('serves a snapshotted image inline from its original stored object', async () => {
    const getDownloadStream = jest.fn(async () => Readable.from(['file-bytes']));
    mockGetStrategyFunctions.mockReturnValue({ getDownloadStream });
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/images/owner/pic.png',
        type: 'image/png',
        filename: 'pic.png',
      },
      hasSnapshots: true,
    });

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toContain('inline');
    expect(mockGetStrategyFunctions).toHaveBeenCalledWith('local');
    expect(getDownloadStream).toHaveBeenCalledWith(expect.anything(), '/images/owner/pic.png');
    expect(backfillSharedLinkFiles).not.toHaveBeenCalled();
  });

  it('reapplies the current file policy before serving a snapshotted file', async () => {
    const liveFile = {
      file_id: 'file-1',
      status: 'ready',
      filename: 'report.pdf',
      text: 'safe extracted text',
    };
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/uploads/owner/file-1',
        type: 'application/pdf',
        filename: 'report.pdf',
      },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([liveFile]);

    const response = await request(buildApp({ filters: contentFilters })).get(
      '/api/share/share-123/files/file-1/download',
    );

    expect(response.status).toBe(200);
    expect(mockAssertModelBoundContent).toHaveBeenCalledWith({
      filters: contentFilters,
      files: [liveFile],
    });
  });

  it('returns a raw-free 400 before serving a file that fails the current policy', async () => {
    const error = Object.assign(new Error('PRIVATE-SENTINEL'), {
      code: 'content_filter_uninspectable',
      statusCode: 400,
      body: {
        error: 'content_filter_uninspectable',
        message: 'Submitted file content could not be inspected before processing.',
        source: 'file',
        field: 'content',
      },
    });
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/uploads/owner/file-1',
        type: 'application/pdf',
        filename: 'PRIVATE-SENTINEL.pdf',
      },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([
      { file_id: 'file-1', status: 'ready', filename: 'PRIVATE-SENTINEL.pdf' },
    ]);
    mockAssertModelBoundContent.mockImplementationOnce(() => {
      throw error;
    });

    const response = await request(buildApp({ filters: contentFilters })).get(
      '/api/share/share-123/files/file-1/download',
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual(error.body);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE-SENTINEL');
    expect(mockGetStrategyFunctions).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('forces attachment for unsafe inline types (no stored XSS)', async () => {
    const getDownloadStream = jest.fn(async () => Readable.from(['<svg/>']));
    mockGetStrategyFunctions.mockReturnValue({ getDownloadStream });
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/uploads/owner/evil.svg',
        type: 'image/svg+xml',
        filename: 'evil.svg',
      },
      hasSnapshots: true,
    });

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/octet-stream');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('downloads a snapshotted file as an attachment', async () => {
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/uploads/owner/file-1',
        type: 'application/pdf',
        filename: 'report.pdf',
      },
      hasSnapshots: true,
    });

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1/download');

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('attachment');
  });

  it('returns preview status read live from the file record', async () => {
    getSharedLinkFile.mockResolvedValue({
      file: { file_id: 'file-1', source: 'local' },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([{ status: 'ready', text: 'extracted text', textFormat: 'text' }]);

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1/preview');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      file_id: 'file-1',
      status: 'ready',
      text: 'extracted text',
      textFormat: 'text',
    });
    expect(getFiles).toHaveBeenCalledWith({ file_id: 'file-1' }, null, {});
  });

  it('404s for a file not in the snapshot without rebuilding it', async () => {
    getSharedLinkFile.mockResolvedValue({ file: null, hasSnapshots: true });

    const response = await request(buildApp()).get('/api/share/share-123/files/not-shared');

    expect(response.status).toBe(404);
    expect(backfillSharedLinkFiles).not.toHaveBeenCalled();
    expect(mockGetStrategyFunctions).not.toHaveBeenCalled();
  });

  it('lazily backfills only a legacy share that has no snapshot field', async () => {
    getSharedLinkFile.mockResolvedValue({ file: null, hasSnapshots: false });
    backfillSharedLinkFiles.mockResolvedValue({
      file_id: 'file-1',
      source: 'local',
      filepath: '/images/owner/pic.png',
      type: 'image/png',
      filename: 'pic.png',
    });

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(200);
    expect(backfillSharedLinkFiles).toHaveBeenCalledWith('share-123', 'file-1');
  });

  it('404s cleanly when the snapshotted file is no longer available', async () => {
    getSharedLinkFile.mockResolvedValue({
      file: { file_id: 'file-1', source: 'local', filepath: '/uploads/owner/gone.pdf' },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([]); // original record deleted/expired

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(404);
    expect(mockGetStrategyFunctions).not.toHaveBeenCalled();
  });

  it('404s (no serving) when the global kill switch is active', async () => {
    isFileSnapshotKillSwitchActive.mockReturnValueOnce(true);

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(404);
    expect(getSharedLinkFile).not.toHaveBeenCalled();
    expect(mockGetStrategyFunctions).not.toHaveBeenCalled();
  });

  it('404s (no serving, no backfill) for a link that opted out of file sharing', async () => {
    getSharedLinkFile.mockResolvedValue({ file: null, hasSnapshots: false, optedOut: true });

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(404);
    expect(backfillSharedLinkFiles).not.toHaveBeenCalled();
    expect(mockGetStrategyFunctions).not.toHaveBeenCalled();
  });

  it('404s when the snapshotted file version was overwritten (revision mismatch)', async () => {
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/uploads/owner/x',
        previewRevision: 'r1',
      },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([{ status: 'ready', previewRevision: 'r2' }]);

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(404);
    expect(mockGetStrategyFunctions).not.toHaveBeenCalled();
  });

  it('404s when the snapshotted file was overwritten (size/bytes mismatch)', async () => {
    getSharedLinkFile.mockResolvedValue({
      file: { file_id: 'file-1', source: 'local', filepath: '/uploads/owner/x', bytes: 100 },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([{ status: 'ready', bytes: 200 }]);

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(404);
    expect(mockGetStrategyFunctions).not.toHaveBeenCalled();
  });

  it('404s when a same-size file reuse has a different source generation', async () => {
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/uploads/owner/x',
        bytes: 100,
        previewRevision: null,
        sourceDispatchedAt: 1000,
      },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([
      {
        status: 'ready',
        bytes: 100,
        previewRevision: null,
        metadata: { sourceDispatchedAt: 2000 },
      },
    ]);

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(404);
    expect(mockGetStrategyFunctions).not.toHaveBeenCalled();
  });

  it('uses legacy snapshot markers when only the live file has a source generation', async () => {
    const getDownloadStream = jest.fn(async () => Readable.from(['bytes']));
    mockGetStrategyFunctions.mockReturnValue({ getDownloadStream });
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/uploads/owner/x',
        bytes: 100,
      },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([
      {
        status: 'ready',
        bytes: 100,
        metadata: { sourceDispatchedAt: 2000 },
      },
    ]);

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(200);
    expect(getDownloadStream).toHaveBeenCalled();
  });

  it('strips a cache-busting query string before local streaming', async () => {
    const getDownloadStream = jest.fn(async () => Readable.from(['bytes']));
    mockGetStrategyFunctions.mockReturnValue({ getDownloadStream });
    getSharedLinkFile.mockResolvedValue({
      file: {
        file_id: 'file-1',
        source: 'local',
        filepath: '/images/owner/pic.png?v=2',
        type: 'image/png',
        filename: 'pic.png',
        bytes: 100,
      },
      hasSnapshots: true,
    });
    getFiles.mockResolvedValue([{ status: 'ready', bytes: 100 }]);

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1');

    expect(response.status).toBe(200);
    expect(getDownloadStream).toHaveBeenCalledWith(expect.anything(), '/images/owner/pic.png');
  });

  it('sweeps an orphaned pending preview to failed', async () => {
    getSharedLinkFile.mockResolvedValue({
      file: { file_id: 'file-1', source: 'local' },
      hasSnapshots: true,
    });
    const stale = new Date(Date.now() - 5 * 60 * 1000);
    getFiles.mockResolvedValue([{ status: 'pending', updatedAt: stale }]);
    updateFile.mockResolvedValue({ status: 'failed', previewError: 'orphaned' });

    const response = await request(buildApp()).get('/api/share/share-123/files/file-1/preview');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      file_id: 'file-1',
      status: 'failed',
      previewError: 'orphaned',
    });
    expect(updateFile).toHaveBeenCalledWith(
      { file_id: 'file-1', status: 'failed', previewError: 'orphaned' },
      { status: 'pending', updatedAt: stale },
    );
  });
});
