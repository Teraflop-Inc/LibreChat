import fs from 'fs';
import type { ServerRequest, STTService } from '~/types';
import { UninspectableFileError } from '~/protection/files';
import { processAudioFile } from './audio';

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));

describe('processAudioFile transcript inspection coverage', () => {
  const file = {
    path: '/tmp/audio.webm',
    originalname: 'audio.webm',
    mimetype: 'audio/webm',
    size: 5,
  };

  const createRequest = (uninspectable?: 'allow' | 'block') =>
    ({
      config: {
        filters: {
          files: {
            pii: {
              fields: ['transcript'],
              uninspectable,
            },
          },
        },
      },
    }) as ServerRequest;

  const createSttService = (sttRequest: STTService['sttRequest']): STTService => ({
    getInstance: jest.fn(),
    getProviderSchema: jest.fn().mockResolvedValue(['openai', {}]),
    sttRequest,
  });

  beforeEach(() => {
    jest.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from('audio'));
  });

  it('fails closed when strict transcript inspection cannot transcribe supported audio', async () => {
    const sttService = createSttService(jest.fn().mockRejectedValue(new Error('provider failed')));

    await expect(
      processAudioFile({ req: createRequest('block'), file, sttService }),
    ).rejects.toBeInstanceOf(UninspectableFileError);
  });

  it('fails closed when transcription produces no inspectable text', async () => {
    const sttService = createSttService(jest.fn().mockResolvedValue('   '));

    await expect(
      processAudioFile({ req: createRequest('block'), file, sttService }),
    ).rejects.toBeInstanceOf(UninspectableFileError);
  });

  it('returns a produced transcript for downstream inspection under strict policy', async () => {
    const sttService = createSttService(jest.fn().mockResolvedValue('inspectable transcript'));

    await expect(
      processAudioFile({ req: createRequest('block'), file, sttService }),
    ).resolves.toEqual({ text: 'inspectable transcript', bytes: 22 });
  });
});
