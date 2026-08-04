import { logger } from '@librechat/data-schemas';
import type { MessageFilterPiiConfig } from 'librechat-data-provider';
import type { TextContentFragment } from './types';
import { createLegacyPiiInspector, inspectLegacyPii, toLegacyPiiMatch } from './legacy';
import { extractMessageContent } from './adapters/messages';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

function fragment(
  id: string,
  text: string,
): Extract<TextContentFragment, { readonly source: 'message' }> {
  return {
    id,
    text,
    path: `/${id}`,
    source: 'message',
    field: 'text',
    format: 'plain',
    treatment: 'replaceable',
    provenance: 'user',
  };
}

describe('legacy content protection', () => {
  it('returns a raw-free finding and converts it to the public legacy match', () => {
    const secret = 'sk-proj-FAKE1234567890ABCDEF';
    const finding = inspectLegacyPii(
      [fragment('external-message.0.content', `my key is ${secret}`)],
      {},
    );

    expect(finding).toEqual({
      detectorId: 'legacy-pattern',
      ruleId: 'sk_prefix',
      label: 'sk- prefix token',
      source: 'message',
      field: 'text',
      provenance: 'user',
      fragmentId: 'external-message.0.content',
      fragmentPath: '/external-message.0.content',
    });
    expect(JSON.stringify(finding)).not.toContain(secret);
    expect(toLegacyPiiMatch(finding)).toEqual({
      id: 'sk_prefix',
      label: 'sk- prefix token',
    });
  });

  it('applies legacy message rules to provenance-selected stored message prose', () => {
    const config: MessageFilterPiiConfig = {
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-VALUE' }],
    };

    expect(
      inspectLegacyPii([fragment('stored-message.text', 'PRIVATE-VALUE')], config),
    ).toMatchObject({
      ruleId: 'private',
      source: 'message',
      field: 'text',
    });
    expect(
      inspectLegacyPii(
        [
          {
            ...fragment('stored-message.name.sender', 'PRIVATE-VALUE'),
            field: 'name',
          },
        ],
        config,
      ),
    ).toBeNull();
  });

  it.each(['stored-message.assembled', 'stored-message.user-submitted-assembled'])(
    'applies legacy rules to split submitted prose through %s',
    (id) => {
      const config: MessageFilterPiiConfig = {
        starterPatterns: [],
        customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-VALUE' }],
      };
      const assembled: TextContentFragment = {
        ...fragment(id, 'PRIVATE-VALUE'),
        source: 'assembled_context',
        field: 'assembled_context',
        treatment: 'inspect_only',
      };

      expect(
        inspectLegacyPii(
          [
            fragment('stored-message.part.0', 'PRIVATE-'),
            fragment('stored-message.part.1', 'VALUE'),
          ],
          config,
        ),
      ).toBeNull();
      expect(inspectLegacyPii([assembled], config)).toMatchObject({
        ruleId: 'private',
        source: 'assembled_context',
        field: 'assembled_context',
      });
    },
  );

  it('preserves candidate-first ordering when different rules match different fields', () => {
    const config: MessageFilterPiiConfig = {
      starterPatterns: [],
      customPatterns: [
        { id: 'first-rule', label: 'A value', regex: 'VALUE-A' },
        { id: 'second-rule', label: 'B value', regex: 'VALUE-B' },
      ],
    };

    const finding = inspectLegacyPii(
      [
        fragment('external-message.0.content', 'VALUE-B'),
        fragment('external-message.1.content', 'VALUE-A'),
      ],
      config,
    );

    expect(finding?.ruleId).toBe('second-rule');
    expect(finding?.fragmentId).toBe('external-message.0.content');
  });

  it('does not read later message content after the first finding', () => {
    const readLaterContent = jest.fn(() => {
      throw new Error('later content should not be read');
    });
    const messages = [
      { content: 'sk-proj-FAKE1234567890ABCDEF' },
      {
        get content() {
          return readLaterContent();
        },
      },
    ];
    const inspector = createLegacyPiiInspector({});

    const finding = inspector?.inspect(extractMessageContent(messages));

    expect(finding?.ruleId).toBe('sk_prefix');
    expect(readLaterContent).not.toHaveBeenCalled();
  });

  it('keeps legacy matching limited to the fields it historically inspected', () => {
    const config: MessageFilterPiiConfig = {};
    const inspector = createLegacyPiiInspector(config);
    const secret = 'sk-proj-FAKE1234567890ABCDEF';

    expect(
      inspector?.inspect([
        {
          ...fragment('external-message.0.name', secret),
          field: 'name',
        },
        {
          ...fragment('external-message.0.part.0.attachment.filename', secret),
          field: 'attachment_reference',
        },
        {
          ...fragment('external-message.0.tool-call.0.arguments', secret),
          source: 'tool_argument',
          field: 'arguments',
        },
      ]),
    ).toBeNull();
    expect(
      inspector?.inspect([
        {
          ...fragment('external-message.0.content', secret),
          field: 'text',
        },
      ]),
    ).not.toBeNull();
  });

  it('compiles once per config identity and warns once for an invalid pattern', () => {
    jest.mocked(logger.warn).mockClear();
    const config = {
      starterPatterns: [],
      customPatterns: [{ id: 'broken', label: 'Broken', regex: '(' }],
    } as MessageFilterPiiConfig;

    expect(inspectLegacyPii([], config)).toBeNull();
    expect(inspectLegacyPii([], config)).toBeNull();

    expect(createLegacyPiiInspector(config)).toBe(createLegacyPiiInspector(config));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[messageFilter.pii] dropping invalid customPattern "broken":'),
    );
  });

  it('preserves JavaScript regex compatibility for legacy custom patterns', () => {
    jest.mocked(logger.warn).mockClear();
    const config = {
      starterPatterns: [],
      customPatterns: [
        { id: 'lookahead', label: 'Lookahead', regex: '(?=PRIVATE)PRIVATE' },
        { id: 'backreference', label: 'Backreference', regex: '([A-Z]{3})-\\1' },
      ],
    } as MessageFilterPiiConfig;

    expect(
      inspectLegacyPii([fragment('external-message.0.content', 'PRIVATE')], config)?.ruleId,
    ).toBe('lookahead');
    expect(
      inspectLegacyPii([fragment('external-message.0.content', 'ABC-ABC')], config)?.ruleId,
    ).toBe('backreference');
    expect(
      inspectLegacyPii([fragment('external-message.0.content', 'SECRET\u00a0KEY')], {
        starterPatterns: [],
        customPatterns: [{ id: 'whitespace', label: 'Whitespace', regex: 'SECRET\\sKEY' }],
      })?.ruleId,
    ).toBe('whitespace');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('fails closed without executing an unsafe legacy native pattern', () => {
    jest.mocked(logger.warn).mockClear();
    const config = {
      starterPatterns: [],
      customPatterns: [
        {
          id: 'unsafe-native',
          label: 'Unsafe native',
          regex: '(a+)+$',
        },
      ],
    } as MessageFilterPiiConfig;

    const finding = inspectLegacyPii([fragment('external-message.0.content', 'safe')], config);

    expect(finding?.ruleId).toBe('unsafe-native');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '[messageFilter.pii] failing closed for unsafe customPattern "unsafe-native"',
      ),
    );
  });

  it('fails closed when a valid legacy native pattern cannot be analyzed', () => {
    jest.mocked(logger.warn).mockClear();
    const config = {
      starterPatterns: [],
      customPatterns: [
        {
          id: 'named-backreference',
          label: 'Named backreference',
          regex: '(?<word>[A-Z]+)-\\k<word>',
        },
      ],
    } as MessageFilterPiiConfig;

    const finding = inspectLegacyPii([fragment('external-message.0.content', 'safe')], config);

    expect(finding?.ruleId).toBe('named-backreference');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '[messageFilter.pii] failing closed because customPattern "named-backreference" could not be analyzed',
      ),
    );
  });

  it('fails closed before compiling an oversized legacy native pattern', () => {
    jest.mocked(logger.warn).mockClear();
    const config = {
      starterPatterns: [],
      customPatterns: [
        {
          id: 'oversized-pattern',
          label: 'Oversized pattern',
          regex: 'A'.repeat(513),
        },
      ],
    } as MessageFilterPiiConfig;

    const finding = inspectLegacyPii([fragment('external-message.0.content', 'safe')], config);

    expect(finding?.ruleId).toBe('oversized-pattern');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '[messageFilter.pii] failing closed because customPattern "oversized-pattern" is too long',
      ),
    );
  });

  it('fails closed on oversized input before running a legacy native pattern', () => {
    jest.mocked(logger.warn).mockClear();
    const config = {
      starterPatterns: [],
      customPatterns: [{ id: 'lookahead', label: 'Lookahead', regex: '(?=PRIVATE)PRIVATE' }],
    } as MessageFilterPiiConfig;

    const finding = inspectLegacyPii(
      [fragment('external-message.0.content', 'a'.repeat(64 * 1024 + 1))],
      config,
    );

    expect(finding?.ruleId).toBe('lookahead');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '[messageFilter.pii] blocking oversized input for customPattern "lookahead"',
      ),
    );
  });
});
